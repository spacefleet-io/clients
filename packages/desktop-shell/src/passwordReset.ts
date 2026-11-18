/**
 * "Forgot password?" on a computer (ACCT-AUTH-05, ACCT-SIGNIN-05): one contract for Badger desktop (calls the API from
 * its window) and Parrot desktop (calls it from main, over IPC). Both answer with a plain result the shared dialog
 * (`DesktopPasswordResetDialog`) turns into words, so the two apps say the same thing for the same answer.
 */
import { ApiError } from "@space/shared/api";
import { isRateLimited, retryAfterMinutes, signInErrorDetails } from "@space/shared/signInError";

export type DesktopPasswordResetFailure = "tooManyAttempts" | "invalidCode" | "failed";

export type DesktopPasswordResetResult =
  | { ok: true }
  | { ok: false; failure: DesktopPasswordResetFailure; retryAfterMinutes: number };

export type DesktopPasswordResetActions = {
  /** Mails a reset code to `email` (the API answers the same whether or not the account exists). */
  request(email: string): Promise<DesktopPasswordResetResult>;
  /** Sets `newPassword` with the mailed `code`. */
  confirm(input: { email: string; code: string; newPassword: string }): Promise<DesktopPasswordResetResult>;
};

type PasswordResetApi = {
  requestPasswordReset(email: string): Promise<unknown>;
  confirmPasswordReset(email: string, code: string, newPassword: string): Promise<unknown>;
};

/** The result of one API call: a refused (rate-limited) call says when to try again, a wrong code says so. */
export const passwordResetResultOf = async (
  call: () => Promise<unknown>,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<DesktopPasswordResetResult> => {
  try {
    await call();
    return { ok: true };
  } catch (error) {
    const failure: DesktopPasswordResetFailure = isRateLimited(error)
      ? "tooManyAttempts"
      : error instanceof ApiError && error.payload.error === "invalid_code"
        ? "invalidCode"
        : "failed";
    log(`[auth] password reset failed: ${failure} ${JSON.stringify(signInErrorDetails(error))}`);
    return { ok: false, failure, retryAfterMinutes: retryAfterMinutes(error) };
  }
};

/** The actions over the API calls, wherever they run (the window for Badger, main for Parrot). */
export const createPasswordResetActions = (
  api: PasswordResetApi,
  log?: (line: string) => void,
): DesktopPasswordResetActions => ({
  request: (email) => passwordResetResultOf(() => api.requestPasswordReset(email.trim()), log),
  confirm: ({ email, code, newPassword }) =>
    passwordResetResultOf(() => api.confirmPasswordReset(email.trim(), code.trim(), newPassword), log),
});
