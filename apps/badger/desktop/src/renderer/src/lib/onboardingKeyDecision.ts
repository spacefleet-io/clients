import type { LibraryMeta } from "@space/shared/api";

export type OnboardingRemoteDecision = {
  mode: "generate" | "enter";
  promptReason: "invalid" | "remote" | "missing" | null;
};

// tla: VaultKeys/SpinAnswered
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
// tla: VaultKeys/SpinAnswered
export const deriveNoStoredKeyDecision = (
  meta: Pick<LibraryMeta, "exists" | "bootstrapRequired" | "keyProbe">
): OnboardingRemoteDecision =>
  deriveOnboardingRemoteDecision({
    existingKey: false,
    libraryError: false,
    remoteExists: meta.exists || Boolean(meta.keyProbe),
    bootstrapRequired: meta.bootstrapRequired,
  });

/**
 * Decision when this device holds a stored key, from the server's library meta. A key probe means the account has a
 * key (PRIV-KEY-01): the stored key is checked against it, even when this app has no library yet (`exists:false`, as
 * after a rotation, or a key made in Parrot) — opens: keep it; fails: forget it and ask for the account's key. Never
 * new words over a probe: they would replace the key every other device holds (PRIV-KEY-08). With no probe, a library
 * from before probes is checked by opening its snapshot; no library and no probe falls to the no-key decision.
 */
export type StoredKeyDecision =
  | { kind: "verify"; by: "probe" | "snapshot" }
  | { kind: "decide"; decision: OnboardingRemoteDecision };

// tla: VaultKeys/SpinAnswered
export const deriveStoredKeyDecision = (
  meta: Pick<LibraryMeta, "exists" | "bootstrapRequired" | "keyProbe">
): StoredKeyDecision => {
  if (meta.keyProbe) return { kind: "verify", by: "probe" };
  if (meta.exists) return { kind: "verify", by: "snapshot" };
  return {
    kind: "decide",
    decision: deriveOnboardingRemoteDecision({
      existingKey: false,
      libraryError: false,
      remoteExists: false,
      bootstrapRequired: meta.bootstrapRequired,
    }),
  };
};
