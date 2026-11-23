import { ApiError, rotateLibraryKey, type RotationLibraryCopy, type RotationOwnLibrary } from "@/api";

type Translate = (key: string) => string;

/**
 * PRIV-KEY-06: rotates the key with every other app's library re-encrypted under the new key, in one request. A library
 * edited between the read and the rotation answers 409 `version_conflict` (nothing changed); the user tries again,
 * which reads it again. No automatic retry: the request's 2FA code is single-use, so a resend would be refused.
 * PRIV-KEY-13: this device's own library goes as a snapshot under the new key declaring its formats, never a whole blob.
 */
export const rotateWithOtherLibraries = async (input: {
  token: string;
  library: RotationOwnLibrary;
  keyProbe: string;
  password: string;
  twoFactorCode?: string;
  reencrypt: () => Promise<RotationLibraryCopy[]>;
}) => {
  const copies = await input.reencrypt();
  return rotateLibraryKey(input.token, input.library, input.keyProbe, input.password, input.twoFactorCode, copies);
};

/**
 * The words for a rotation that was refused with nothing changed, or null for any other error. The media refusal
 * (409 `rotation_needs_media_reseal`) has no words: no entry is offered while the server would answer it
 * (ACCT-KEYCHG-04), so reaching it is a fault and gets the generic error.
 */
export const rotationRefusalText = (t: Translate, err: unknown): string | null => {
  if (err instanceof ApiError) {
    if (err.payload.error === "library_not_reencrypted") return t("settings.recovery.rotate.errorNotReencrypted");
    if (err.payload.error === "version_conflict") return t("settings.recovery.rotate.errorChanged");
    return null;
  }
  if (!(err instanceof Error)) return null;
  if (err.message === "ROTATION_REENCRYPT_UNREADABLE") return t("settings.recovery.rotate.errorUnreadable");
  if (err.message === "ROTATION_REENCRYPT_NOT_SNAPSHOTTED") return t("settings.recovery.rotate.errorNotSnapshotted");
  if (err.message === "ROTATION_REENCRYPT_FAILED") return t("settings.recovery.rotate.errorReencryptFailed");
  return null;
};
