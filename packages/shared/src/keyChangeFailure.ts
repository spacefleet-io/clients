import { ApiError } from "./api";
import type { ClientUiLanguage } from "./i18n";
import { keyChangeText, type KeyChangeStringKey } from "./keyChangeText";
import { isRateLimited, retryAfterMinutes, signInErrorText } from "./signInError";

/**
 * Why a key change (ACCT-KEYCHG-01) stopped with nothing changed: the media library key, the library and the media
 * stay as they were, and the user tries again (or, for `resealIncomplete`, finishes the same run). Plain data, so it
 * crosses Electron IPC as is.
 */
export type KeyChangeFailureReason =
  | "invalidPassword"
  | "invalidCode"
  | "changed"
  | "resealIncomplete"
  | "resealStopped"
  | "notReencrypted"
  | "unreadable"
  | "notSnapshotted"
  | "reencryptFailed"
  | "other";

/** `codeNeeded`: the account has two-factor on, the dialog asks for the code (emailed when `method` is "email"). */
export type KeyChangeFailure =
  | { status: "codeNeeded"; method: "totp" | "email" }
  | { status: "failed"; reason: KeyChangeFailureReason }
  | { status: "failed"; reason: "tooManyAttempts"; minutes: number };

const API_REFUSALS: Record<string, KeyChangeFailureReason> = {
  invalid_password: "invalidPassword",
  two_factor_invalid: "invalidCode",
  // PRIV-KEY-06: a library edited between the read and the rotation; reading it again fixes it.
  version_conflict: "changed",
  // STOR-RESEAL-04: files added since the re-seal listed them; Finish copies them too.
  media_reseal_incomplete: "resealIncomplete",
  // STOR-RESEAL-07: the run was stopped (on another device) before the switch.
  reseal_run_not_open: "resealStopped",
  library_not_reencrypted: "notReencrypted",
};

const REENCRYPT_REFUSALS: Record<string, KeyChangeFailureReason> = {
  ROTATION_REENCRYPT_UNREADABLE: "unreadable",
  ROTATION_REENCRYPT_NOT_SNAPSHOTTED: "notSnapshotted",
  ROTATION_REENCRYPT_FAILED: "reencryptFailed",
};

/**
 * What a key change error means, for Badger's renderer and Parrot's main process alike. The media refusal (409
 * `rotation_needs_media_reseal`) maps to `other`: no entry is offered while the server would answer it (ACCT-KEYCHG-04).
 */
export const keyChangeFailureOf = (err: unknown): KeyChangeFailure => {
  // ACCT-AUTH-11: too many wrong passwords or codes (429, OPS-LIMIT-05) says when to try again.
  if (isRateLimited(err)) return { status: "failed", reason: "tooManyAttempts", minutes: retryAfterMinutes(err) };
  if (err instanceof ApiError) {
    const payload = err.payload as { error?: string; method?: string } | undefined;
    if (payload?.error === "two_factor_required") return { status: "codeNeeded", method: payload.method === "totp" ? "totp" : "email" };
    return { status: "failed", reason: (payload?.error && API_REFUSALS[payload.error]) || "other" };
  }
  if (err instanceof Error) return { status: "failed", reason: REENCRYPT_REFUSALS[err.message] ?? "other" };
  return { status: "failed", reason: "other" };
};

const FAILURE_KEYS: Record<KeyChangeFailureReason, KeyChangeStringKey> = {
  invalidPassword: "error.invalidPassword",
  invalidCode: "error.invalidCode",
  changed: "error.changed",
  resealIncomplete: "error.resealIncomplete",
  resealStopped: "error.resealStopped",
  notReencrypted: "error.notReencrypted",
  unreadable: "error.unreadable",
  notSnapshotted: "error.notSnapshotted",
  reencryptFailed: "error.reencryptFailed",
  other: "error.generic",
};

/**
 * The sentence for a failed key change in `language`. `other` names the app whose library is re-encrypted alongside
 * (PRIV-KEY-06): "Parrot" on Badger, "Badger" on Parrot.
 */
export const keyChangeFailureText = (
  language: ClientUiLanguage,
  failure: Extract<KeyChangeFailure, { status: "failed" }>,
  other: string,
): string =>
  failure.reason === "tooManyAttempts"
    ? signInErrorText(language, "tooManyAttempts", failure.minutes)
    : keyChangeText(language)(FAILURE_KEYS[failure.reason], { other });

/**
 * The sentence for a refusal that changed nothing and that the user fixes by trying again, or null for any other error
 * (password, code, rate limit or a fault): for screens with their own password and code sentences (Badger onboarding).
 */
export const keyChangeRefusalText = (language: ClientUiLanguage, err: unknown, other: string): string | null => {
  const failure = keyChangeFailureOf(err);
  if (failure.status !== "failed" || failure.reason === "tooManyAttempts") return null;
  if (failure.reason === "other" || failure.reason === "invalidPassword" || failure.reason === "invalidCode") return null;
  return keyChangeFailureText(language, failure, other);
};
