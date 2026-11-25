import { useCallback, useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import { ApiError, completeProviderSignIn, listSignInProviders, startProviderSignIn } from "@space/shared/api";
import type { LoginDevice, SignInProvider, User } from "@space/shared/api";
import type { AccountLanguage } from "@space/shared/i18n";
import { newProviderClientSecret, parseProviderReturnLink, providerReturnAddress } from "@space/shared/providerSignIn";
import type { ProviderReturn, ProviderSignInErrorCode } from "@space/shared/providerSignIn";
import { isRateLimited, signInErrorMessageKey, signInErrorValues, TOO_MANY_ATTEMPTS_KEY } from "@space/shared/signInError";
import type { SignInErrorValues } from "@space/shared/signInError";
import { scopeLogger } from "./logger";

/**
 * The Google, Apple and Microsoft sign-in on a phone (ACCT-SIGNIN-05), shared by the Badger and Parrot phones. A row
 * starts the sign-in at the API with the SHA-256 of a fresh secret and opens the provider in the system browser; the
 * API sends the browser back to `<scheme>://auth/provider` with `signinCode` or `signinError`. The app's root hands
 * every link to {@link handOffProviderReturn}; the sign-in screen's {@link useMobileProviderSignIn} trades the code and
 * the secret for a session. An email with no account gets a new free account, as on the website (ACCT-AUTH-10).
 */

const log = scopeLogger("provider-sign-in");

/**
 * Where the phone keeps the secret whose hash started the sign-in: persisted, so an app the system killed while the
 * person was at the provider still finishes. Worth nothing without the code, and dropped once used or refused.
 */
export const PROVIDER_VERIFIER_KEY = "sf_provider_sign_in_verifier";

export type ProviderVerifierStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

/** The words for a `signinError` (or a completion's `invalid_code`), under `login.provider.errors`. */
export const providerSignInErrorKey = (code: ProviderSignInErrorCode) => `login.provider.errors.${code}`;

// Per scheme: the sign-in screen listening now, and an outcome that came while none was (a cold start through the
// link, before the screen mounted). Each outcome is delivered once.
const listeners = new Map<string, (outcome: ProviderReturn) => void>();
const unclaimed = new Map<string, ProviderReturn>();

/**
 * Hands a link the app received (cold start or while running) to the sign-in screen when it is a provider return
 * (`<scheme>://auth/provider?...`). Returns false for any other link, which the caller handles as before.
 */
export const handOffProviderReturn = (scheme: string, url: string | null | undefined): boolean => {
  const outcome = parseProviderReturnLink(scheme, url);
  if (outcome === null) return false;
  const listener = listeners.get(scheme);
  log.info("return.handedOff", { outcome: "code" in outcome ? "code" : outcome.error, listening: listener !== undefined });
  if (listener) listener(outcome);
  else unclaimed.set(scheme, outcome);
  return true;
};

/** A line for the sign-in screen's notice: an i18n key, translated at render so it follows a language switch. */
export type ProviderSignInNotice = { kind: "error" | "info"; key: string; values?: SignInErrorValues };

type UseMobileProviderSignInInput = {
  /** The app's link scheme: `spacebadger`, `parrot`. */
  scheme: string;
  /** False draws no rows and takes no return (TV). */
  enabled: boolean;
  storage: ProviderVerifierStorage;
  /** The name and type this device shows in the account's device list (ACCT-DEV-01). */
  device: LoginDevice;
  /** The provider's pages in this language when the screen shows one the API knows. */
  uiLanguage?: AccountLanguage;
  /** Starts the session the completion returned, as a password sign-in does. */
  setSession: (token: string, user: User) => Promise<void>;
  onNotice: (notice: ProviderSignInNotice | null) => void;
};

export const useMobileProviderSignIn = ({ scheme, enabled, storage, device, uiLanguage, setSession, onNotice }: UseMobileProviderSignInInput) => {
  const [providers, setProviders] = useState<SignInProvider[]>([]);
  const [busy, setBusy] = useState<SignInProvider | null>(null);
  const [finishing, setFinishing] = useState(false);
  // The returned code while the account's second step is asked for: the same code is traded again with it.
  const [secondStep, setSecondStep] = useState<{ code: string; method: "totp" | "email" } | null>(null);
  const latest = useRef({ storage, device, setSession, onNotice });
  latest.current = { storage, device, setSession, onNotice };

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    listSignInProviders()
      .then(({ providers: on }) => {
        log.info("providers.listed", { providers: on });
        if (live) setProviders(on);
      })
      .catch((err: unknown) => {
        // No list, no rows: the email form still works.
        log.warn("providers.failed", { error: err instanceof Error ? err.name : typeof err });
      });
    return () => {
      live = false;
    };
  }, [enabled]);

  const drop = useCallback(async () => {
    setSecondStep(null);
    await latest.current.storage.removeItem(PROVIDER_VERIFIER_KEY);
  }, []);

  const finish = useCallback(
    async (code: string, twoFactorCode?: string) => {
      const { storage: store, device: thisDevice, onNotice: notify } = latest.current;
      const verifier = await store.getItem(PROVIDER_VERIFIER_KEY);
      if (!verifier) {
        // Started on another device or before a reinstall: its secret is not here.
        log.warn("return.noSecret");
        setSecondStep(null);
        notify({ kind: "error", key: providerSignInErrorKey("invalid_code") });
        return;
      }
      setFinishing(true);
      try {
        const result = await completeProviderSignIn(code, verifier, twoFactorCode, undefined, thisDevice);
        await drop();
        log.info("complete.signedIn");
        notify(null);
        await latest.current.setSession(result.token, result.user);
      } catch (err) {
        const apiError = err instanceof ApiError ? err : null;
        const apiCode = typeof apiError?.payload.error === "string" ? apiError.payload.error : null;
        log.warn("complete.failed", { error: apiCode ?? (err instanceof Error ? err.name : typeof err), status: apiError?.status ?? null });
        if (isRateLimited(err)) {
          notify({ kind: "error", key: TOO_MANY_ATTEMPTS_KEY, values: signInErrorValues(err) });
        } else if (apiCode === "two_factor_required") {
          const method = apiError?.payload.method === "totp" ? "totp" : "email";
          setSecondStep({ code, method });
          notify({ kind: "info", key: method === "totp" ? "login.infoTotp" : "login.infoEmail" });
        } else if (apiCode === "two_factor_invalid") {
          notify({ kind: "error", key: signInErrorMessageKey("twoFactorInvalid"), values: signInErrorValues(err) });
        } else {
          await drop();
          notify({
            kind: "error",
            key: providerSignInErrorKey(apiCode === "invalid_code" || apiCode === "account_deletion_pending" ? apiCode : "provider_failed"),
          });
        }
      } finally {
        setFinishing(false);
      }
    },
    [drop]
  );

  // The browser came back through `<scheme>://auth/provider`: trade the code, or say why there is none.
  const onReturn = useRef<(outcome: ProviderReturn) => void>(() => undefined);
  onReturn.current = (outcome) => {
    if ("error" in outcome) {
      log.info("return.error", { error: outcome.error });
      void drop();
      latest.current.onNotice({ kind: "error", key: providerSignInErrorKey(outcome.error) });
      return;
    }
    void finish(outcome.code);
  };
  useEffect(() => {
    if (!enabled) return undefined;
    const listener = (outcome: ProviderReturn) => onReturn.current(outcome);
    listeners.set(scheme, listener);
    const waiting = unclaimed.get(scheme);
    if (waiting) {
      unclaimed.delete(scheme);
      listener(waiting);
    }
    return () => {
      if (listeners.get(scheme) === listener) listeners.delete(scheme);
    };
  }, [enabled, scheme]);

  const start = useCallback(
    async (provider: SignInProvider) => {
      const { storage: store, onNotice: notify } = latest.current;
      setBusy(provider);
      setSecondStep(null);
      notify(null);
      try {
        const { verifier, challenge } = newProviderClientSecret();
        await store.setItem(PROVIDER_VERIFIER_KEY, verifier);
        const { url } = await startProviderSignIn(provider, {
          returnTo: providerReturnAddress(scheme),
          surface: "phone",
          clientChallenge: challenge,
          ...(uiLanguage ? { uiLanguage } : {}),
        });
        await Linking.openURL(url);
        log.info("start.opened", { provider });
        notify({ kind: "info", key: "login.provider.continueInBrowser" });
      } catch (err) {
        log.warn("start.failed", { provider, error: err instanceof Error ? err.name : typeof err });
        await store.removeItem(PROVIDER_VERIFIER_KEY);
        notify(
          isRateLimited(err)
            ? { kind: "error", key: TOO_MANY_ATTEMPTS_KEY, values: signInErrorValues(err) }
            : { kind: "error", key: "login.provider.errorStart" }
        );
      } finally {
        setBusy(null);
      }
    },
    [scheme, uiLanguage]
  );

  const submitSecondStep = useCallback(
    async (twoFactorCode: string) => {
      if (secondStep) await finish(secondStep.code, twoFactorCode);
    },
    [finish, secondStep]
  );

  return {
    providers: enabled ? providers : [],
    busy,
    finishing,
    /** Set while the account's second step is asked for; the screen shows its code field and calls `submitSecondStep`. */
    secondStep: secondStep ? { method: secondStep.method } : null,
    start,
    submitSecondStep,
  };
};
