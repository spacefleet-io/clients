import { ApiError } from "@space/shared/api";
import { isRateLimited, retryAfterMinutes } from "@space/shared/signInError";

/**
 * How one erase attempt ended (PRIV-KEY-01, `POST /library/recovery/reset`). `codeNeeded`: the account has two-factor
 * on, the dialog asks for the code (sent by email when `method` is "email"). `tooManyAttempts` says when to try again
 * (ACCT-AUTH-11); `message` replaces the generic failure sentence when the app has a better one. Plain data, so it
 * crosses Electron IPC as is.
 */
export type LibraryKeyEraseOutcome =
  | { status: "erased" }
  | { status: "codeNeeded"; method: "totp" | "email" }
  | { status: "failed"; reason: "invalidPassword" | "invalidCode" | "other"; message?: string }
  | { status: "failed"; reason: "tooManyAttempts"; minutes: number };

/** The erase outcome a refused `resetLibrary` call means, for Badger's renderer and Parrot's main process alike. */
export const libraryKeyEraseOutcomeOf = (err: unknown): LibraryKeyEraseOutcome => {
  if (isRateLimited(err)) return { status: "failed", reason: "tooManyAttempts", minutes: retryAfterMinutes(err) };
  if (!(err instanceof ApiError)) return { status: "failed", reason: "other" };
  const payload = err.payload as { error?: string; method?: string } | undefined;
  if (payload?.error === "invalid_password") return { status: "failed", reason: "invalidPassword" };
  if (payload?.error === "two_factor_required") return { status: "codeNeeded", method: payload.method === "totp" ? "totp" : "email" };
  if (payload?.error === "two_factor_invalid") return { status: "failed", reason: "invalidCode" };
  return { status: "failed", reason: "other" };
};
