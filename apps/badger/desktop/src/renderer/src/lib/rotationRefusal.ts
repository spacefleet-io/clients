import { rotateLibraryKey, type RotationLibraryCopy, type RotationMediaReseal, type RotationOwnLibrary } from "@/api";

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
  /** Omitted when `mediaReseal` names the run this session opened with the password (ACCT-KEYCHG-03). */
  password?: string;
  twoFactorCode?: string;
  reencrypt: () => Promise<RotationLibraryCopy[]>;
  /** STOR-RESEAL-04: the re-seal run whose copies replace the media, switched in the same step. */
  mediaReseal?: RotationMediaReseal;
}) => {
  const copies = await input.reencrypt();
  return rotateLibraryKey(input.token, input.library, input.keyProbe, input.password, input.twoFactorCode, copies, input.mediaReseal);
};
