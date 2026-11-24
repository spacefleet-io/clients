import { sha256 } from "@noble/hashes/sha2.js";
import type { ClientUiLanguage } from "./i18n";

/**
 * Client side of the Google, Apple and Microsoft sign-in (ACCT-SIGNIN-05), shared by every app that draws the rows.
 * The app keeps a random secret, sends its SHA-256 when the sign-in starts, and proves it holds the secret when it
 * trades the `signinCode` the browser brings back: a code read by anyone else (a browser history, another app on
 * the same scheme) is worth nothing to them.
 */

/** Why the API sent the browser back without a code (`signinError`), plus `invalid_code` from the completion. */
export const PROVIDER_SIGN_IN_ERRORS = [
  "email_unverified",
  "email_domain_disallowed",
  "account_deletion_pending",
  "provider_failed",
  "cancelled",
  "invalid_code",
] as const;
export type ProviderSignInErrorCode = (typeof PROVIDER_SIGN_IN_ERRORS)[number];

const KNOWN_ERRORS: Record<ProviderSignInErrorCode, true> = {
  email_unverified: true,
  email_domain_disallowed: true,
  account_deletion_pending: true,
  provider_failed: true,
  cancelled: true,
  invalid_code: true,
};

/** A `signinError` value as one of the known codes; anything unknown reads as `provider_failed`. */
export const providerSignInError = (raw: string | null | undefined): ProviderSignInErrorCode =>
  raw && Object.hasOwn(KNOWN_ERRORS, raw) ? (raw as ProviderSignInErrorCode) : "provider_failed";

const base64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

export type ProviderClientSecret = { verifier: string; challenge: string };

/**
 * A fresh secret (`verifier`, kept by the app) and its base64url SHA-256 (`challenge`, sent at the start). Synchronous
 * noble hashing rather than `crypto.subtle`, which React Native lacks; `getRandomValues` is there on every client.
 */
export const newProviderClientSecret = (): ProviderClientSecret => {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: base64url(sha256(new TextEncoder().encode(verifier))) };
};

/** What an app's provider return link carries: the code to trade, or why there is none. */
export type ProviderReturn = { code: string } | { error: ProviderSignInErrorCode };

/** The return address an app passes as `returnTo` (`badger://auth/provider`); the API adds `signinCode` or `signinError`. */
export const providerReturnAddress = (scheme: string): string => `${scheme}://auth/provider`;

const SIGNIN_CODE = /^[A-Za-z0-9_-]{16,200}$/u;

/**
 * The outcome in a `<scheme>://auth/provider?signinCode=…` (or `?signinError=…`) link, or null for any other link.
 * Surrounding quotes (Windows shells) are dropped; a malformed code reads as `invalid_code`, an unknown error as
 * `provider_failed`.
 */
export const parseProviderReturnLink = (scheme: string, value: unknown): ProviderReturn | null => {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/^"(.*)"$/u, "$1");
  if (raw.length > 400 || !raw.toLowerCase().startsWith(`${scheme}:`)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${scheme}:` || url.hostname.toLowerCase() !== "auth" || url.pathname.replace(/\/+$/u, "") !== "/provider") {
    return null;
  }
  const error = url.searchParams.get("signinError");
  if (error !== null) return { error: providerSignInError(error) };
  const code = url.searchParams.get("signinCode");
  return code !== null && SIGNIN_CODE.test(code) ? { code } : { error: "invalid_code" };
};

/** The API keeps a returned code for 5 minutes; an outcome held longer is worth nothing. */
export const PROVIDER_RETURN_TTL_MS = 5 * 60_000;

/**
 * Holds the last provider sign-in outcome until a desktop app's window takes it. A pull, not a push: a window still
 * loading (or created by the link) gets it when its sign-in screen mounts, and each outcome is handed over once, so the
 * single-use code is never traded twice.
 */
export const createProviderReturnMailbox = (now: () => number = Date.now) => {
  let held: { value: ProviderReturn; at: number } | null = null;
  return {
    put: (value: ProviderReturn) => {
      held = { value, at: now() };
    },
    take: (): ProviderReturn | null => {
      const entry = held;
      held = null;
      if (entry === null || now() - entry.at > PROVIDER_RETURN_TTL_MS) return null;
      return entry.value;
    },
  };
};

/**
 * What a desktop app's preload exposes for the return: main nudges on `onReturn` (no payload) and `takeReturn` hands
 * the outcome over once (`createProviderReturnMailbox`), the one that came before the page listened included.
 */
export type ProviderReturnBridge = {
  onReturn: (callback: () => void) => () => void;
  takeReturn: () => Promise<ProviderReturn | null>;
};

/** The languages the provider sign-in words are written in: every app language (UX-I18N-01). */
export type ProviderSignInLanguage = ClientUiLanguage;

/**
 * The words of the Google, Apple and Microsoft sign-in (ACCT-SIGNIN-05), written once for every app: the row titles
 * (`{{provider}}` is the provider's name, never translated), the "or" line above them, the sentence when the browser
 * could not be opened, and one sentence per {@link ProviderSignInErrorCode}. i18next apps load them as
 * `login.provider` with {@link withProviderSignInTexts}; apps with their own string tables read
 * {@link providerSignInTexts} through {@link providerSignInText}. "Finish in your browser" names the app, so each
 * app keeps that sentence (`login.provider.continueInBrowser`) itself.
 */
export type ProviderSignInTexts = {
  signInWith: string;
  signUpWith: string;
  or: string;
  errorStart: string;
  errors: Record<ProviderSignInErrorCode, string>;
};

export const providerSignInTexts: Record<ProviderSignInLanguage, ProviderSignInTexts> = {
  en: {
    signInWith: "Sign in with {{provider}}",
    signUpWith: "Sign up with {{provider}}",
    or: "or",
    errorStart: "Could not start the sign-in. Please try again.",
    errors: {
      email_unverified: "This account's email address is not confirmed. Confirm it with the provider, or sign in with your email and password.",
      email_domain_disallowed: "Accounts with this email address cannot be created.",
      account_deletion_pending: "This account is scheduled for deletion.",
      provider_failed: "The sign-in did not go through. Please try again.",
      cancelled: "The sign-in was cancelled.",
      invalid_code: "This sign-in has expired or was started elsewhere. Please try again.",
    },
  },
  fr: {
    signInWith: "Se connecter avec {{provider}}",
    signUpWith: "S'inscrire avec {{provider}}",
    or: "ou",
    errorStart: "Impossible de lancer la connexion. Veuillez réessayer.",
    errors: {
      email_unverified: "L'adresse e-mail de ce compte n'est pas confirmée. Confirmez-la auprès du fournisseur, ou connectez-vous avec votre e-mail et votre mot de passe.",
      email_domain_disallowed: "Impossible de créer un compte avec cette adresse e-mail.",
      account_deletion_pending: "La suppression de ce compte est programmée.",
      provider_failed: "La connexion n'a pas abouti. Veuillez réessayer.",
      cancelled: "La connexion a été annulée.",
      invalid_code: "Cette connexion a expiré ou a été lancée ailleurs. Veuillez réessayer.",
    },
  },
  nl: {
    signInWith: "Inloggen met {{provider}}",
    signUpWith: "Registreren met {{provider}}",
    or: "of",
    errorStart: "Inloggen kon niet starten. Probeer het opnieuw.",
    errors: {
      email_unverified: "Het e-mailadres van dit account is niet bevestigd. Bevestig het bij de aanbieder, of log in met je e-mailadres en wachtwoord.",
      email_domain_disallowed: "Met dit e-mailadres kan geen account worden aangemaakt.",
      account_deletion_pending: "Dit account wordt binnenkort verwijderd.",
      provider_failed: "Inloggen is niet gelukt. Probeer het opnieuw.",
      cancelled: "Inloggen is geannuleerd.",
      invalid_code: "Deze inlogpoging is verlopen of ergens anders gestart. Probeer het opnieuw.",
    },
  },
  de: {
    signInWith: "Mit {{provider}} anmelden",
    signUpWith: "Mit {{provider}} registrieren",
    or: "oder",
    errorStart: "Die Anmeldung konnte nicht gestartet werden. Bitte versuch es noch einmal.",
    errors: {
      email_unverified: "Die E-Mail-Adresse dieses Kontos ist nicht bestätigt. Bestätige sie beim Anbieter oder melde dich mit E-Mail und Passwort an.",
      email_domain_disallowed: "Mit dieser E-Mail-Adresse kann kein Konto erstellt werden.",
      account_deletion_pending: "Die Löschung dieses Kontos ist geplant.",
      provider_failed: "Die Anmeldung hat nicht geklappt. Bitte versuch es noch einmal.",
      cancelled: "Die Anmeldung wurde abgebrochen.",
      invalid_code: "Diese Anmeldung ist abgelaufen oder wurde woanders gestartet. Bitte versuch es noch einmal.",
    },
  },
  es: {
    signInWith: "Iniciar sesión con {{provider}}",
    signUpWith: "Registrarse con {{provider}}",
    or: "o",
    errorStart: "No se pudo iniciar el inicio de sesión. Vuelve a intentarlo.",
    errors: {
      email_unverified: "El correo de esta cuenta no está confirmado. Confírmalo con el proveedor o inicia sesión con tu correo y contraseña.",
      email_domain_disallowed: "No se pueden crear cuentas con este correo.",
      account_deletion_pending: "La eliminación de esta cuenta está programada.",
      provider_failed: "No se pudo iniciar sesión. Vuelve a intentarlo.",
      cancelled: "Se canceló el inicio de sesión.",
      invalid_code: "Este inicio de sesión ha caducado o se inició en otro lugar. Vuelve a intentarlo.",
    },
  },
};

/** The i18next key of the sentence for a `signinError` (or a completion's `invalid_code`), under `login.provider.errors`. */
export const providerSignInErrorKey = (code: ProviderSignInErrorCode): `login.provider.errors.${ProviderSignInErrorCode}` =>
  `login.provider.errors.${code}`;

/** Puts {@link providerSignInTexts} into an i18next translation tree as `login.provider`, keeping the tree's other keys. */
export const withProviderSignInTexts = <T extends Record<string, unknown>>(translation: T, language: ProviderSignInLanguage): T => {
  const login = translation.login && typeof translation.login === "object" ? (translation.login as Record<string, unknown>) : {};
  const own = login.provider && typeof login.provider === "object" ? login.provider : {};
  return { ...translation, login: { ...login, provider: { ...own, ...providerSignInTexts[language] } } };
};

/** A row title, or any other provider sign-in sentence, for apps without i18next; `provider` fills `{{provider}}`. */
export const providerSignInText = (
  language: ProviderSignInLanguage,
  key: Exclude<keyof ProviderSignInTexts, "errors">,
  provider = "",
): string => providerSignInTexts[language][key].replace("{{provider}}", provider);
