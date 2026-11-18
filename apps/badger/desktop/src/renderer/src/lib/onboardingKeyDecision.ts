import type { LibraryMeta } from "@space/shared/api";

export type OnboardingRemoteDecision = {
  mode: "generate" | "enter";
  promptReason: "invalid" | "remote" | "missing" | null;
};

export const deriveOnboardingRemoteDecision = (input: {
  existingKey: boolean;
  libraryError: boolean;
  remoteExists: boolean;
  bootstrapRequired: boolean;
}): OnboardingRemoteDecision => {
  if (input.existingKey) {
    return { mode: "enter", promptReason: "remote" };
  }
  if (input.libraryError) {
    return { mode: "enter", promptReason: "invalid" };
  }
  if (input.remoteExists) {
    return { mode: "enter", promptReason: "remote" };
  }
  if (input.bootstrapRequired) {
    return { mode: "generate", promptReason: "missing" };
  }
  return { mode: "enter", promptReason: "missing" };
};

/**
 * Decision when this device holds no key, from the server's library meta.
 * Generate a new key only when the server says no library was ever created
 * (`bootstrapRequired`) and the account has no key probe. `exists:false` alone
 * can mean the saved copy is missing; a probe means the account already has a
 * key (made in Parrot, PRIV-KEY-01: one key per account). A generated key in
 * either case would replace the user's real key.
 */
export const deriveNoStoredKeyDecision = (
  meta: Pick<LibraryMeta, "exists" | "bootstrapRequired" | "keyProbe">
): OnboardingRemoteDecision =>
  deriveOnboardingRemoteDecision({
    existingKey: false,
    libraryError: false,
    remoteExists: meta.exists || Boolean(meta.keyProbe),
    bootstrapRequired: meta.bootstrapRequired,
  });
