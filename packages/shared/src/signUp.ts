import { ApiError } from "@space/sdk";
import { evaluateEmailDomainAgainstSets, parseDomainSet, splitDomainList } from "./emailDomainPolicy";
import { isRateLimited } from "./signInError";

/**
 * Creating an account in a desktop app (ACCT-AUTH-10): the checks the form runs before it asks the API, and how each
 * API answer of sign-up, email verification and "send the code again" is sorted. Badger desktop and Parrot desktop
 * both read this, each with its own words for every outcome.
 */

/** The shortest password the API accepts at sign-up. */
export const SIGN_UP_MIN_PASSWORD_LENGTH = 8;

/** What the form refuses before calling the API. */
export type SignUpInputProblem = "passwordLength" | "emailDomainDisallowed" | "passwordMismatch";

/**
 * Checks the sign-up form in the order the user reads the problems: password length, a throwaway email domain
 * (ACCT-AUTH-02; the API checks again), then the repeated password. `null`: nothing to fix.
 */
export const checkSignUpInput = (
  email: string,
  password: string,
  confirm: string,
  isDisposableEmail: (email: string) => boolean,
): SignUpInputProblem | null => {
  if (password.length < SIGN_UP_MIN_PASSWORD_LENGTH) return "passwordLength";
  if (isDisposableEmail(email)) return "emailDomainDisallowed";
  if (password !== confirm) return "passwordMismatch";
  return null;
};

/**
 * A throwaway-email check from the build's comma-separated lists (`VITE_EMAIL_DOMAIN_ALLOWLIST`,
 * `VITE_DISPOSABLE_EMAIL_DOMAINS`). Without lists it lets everything through and the API decides.
 */
export const disposableEmailCheck =
  (allowList?: string | null, denyList?: string | null) =>
  (email: string): boolean =>
    !evaluateEmailDomainAgainstSets(email, {
      allowSet: parseDomainSet(splitDomainList(allowList)),
      denySet: parseDomainSet(splitDomainList(denyList)),
      upstreamSet: new Set<string>(),
    }).allowed;

/** Why the API refused a sign-up. */
export type SignUpFailure = "emailExists" | "emailDomainDisallowed" | "rateLimited" | "generic";

export const classifySignUpError = (err: unknown): SignUpFailure => {
  if (isRateLimited(err)) return "rateLimited";
  if (err instanceof ApiError) {
    if (err.payload?.error === "email_exists") return "emailExists";
    if (err.payload?.error === "email_domain_disallowed") return "emailDomainDisallowed";
  }
  return "generic";
};

/** Why the API refused an email verification code. */
export type VerifyEmailFailure = "invalidCode" | "rateLimited" | "generic";

export const classifyVerifyEmailError = (err: unknown): VerifyEmailFailure => {
  if (isRateLimited(err)) return "rateLimited";
  if (err instanceof ApiError && err.payload?.error === "invalid_code") return "invalidCode";
  return "generic";
};

/** Why a new verification code could not be sent. */
export type ResendVerificationFailure = "emailNotFound" | "rateLimited" | "sendFailed";

export const classifyResendVerificationError = (err: unknown): ResendVerificationFailure => {
  if (isRateLimited(err)) return "rateLimited";
  if (err instanceof ApiError && err.payload?.error === "email_not_found") return "emailNotFound";
  return "sendFailed";
};
