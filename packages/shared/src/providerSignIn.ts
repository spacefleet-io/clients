import { sha256 } from "@noble/hashes/sha2.js";

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
