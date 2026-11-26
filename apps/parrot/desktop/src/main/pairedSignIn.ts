/**
 * ACCT-PAIR-01 / ACCT-PAIR-05 / PRIV-KEY-05: finishes "Sign in with your phone" on Parrot desktop, in main.
 *
 * A signed-in Badger or Parrot app (phone or computer) approved this computer and handed over a session token and the
 * library key. The key is checked against the account's library BEFORE anything is stored, the way typing the key
 * by hand checks it, so a wrong key never replaces anything. Then the session and the key are kept exactly like a
 * password sign-in followed by the key step, and setup skips the key step. The token and the key never reach the
 * window: it only learns "verified" or "mismatch".
 */
import type { PairedKeyCheck, PairingHandOver } from "@space/desktop-shell/pairing";
import type { AccountKeyResult } from "@space/desktop-shell/account-key-check";
import type { ParrotUser } from "../shared/ipc";

export type ParrotPairedSignInDeps = {
  /** The account this computer was signed in to before, if any. */
  previousUserId: () => string | null;
  /** A different account takes over: save its queued edits, then forget its session, key, library and covers. */
  forgetPreviousAccount: () => Promise<void>;
  /** Whether `key` opens the account's library (Parrot's, else Badger's), checked with `token`; stores nothing. */
  verifyKey: (token: string, key: string) => Promise<AccountKeyResult>;
  signIn: (user: ParrotUser, token: string) => Promise<void>;
  storeKey: (key: string) => Promise<void>;
  log: (line: string) => void;
};

export const completeParrotPairedSignIn = async (deps: ParrotPairedSignInDeps, handOver: PairingHandOver): Promise<PairedKeyCheck> => {
  const user: ParrotUser = { id: handOver.user.id, email: handOver.user.email };
  const verdict = await deps.verifyKey(handOver.token, handOver.libraryKey);
  if (!verdict.ok) {
    if (verdict.error === "network") throw new Error(`could not check the library key: ${verdict.message ?? "network"}`);
    deps.log(`[pairing] the key from the phone does not open the library of user ${user.id} (${verdict.error}); nothing stored`);
    return "mismatch";
  }
  const previous = deps.previousUserId();
  if (previous && previous !== user.id) {
    deps.log(`[pairing] another account signs in (was ${previous}); forgetting the previous one`);
    await deps.forgetPreviousAccount();
  }
  // The session first: the key is kept per signed-in user.
  await deps.signIn(user, handOver.token);
  await deps.storeKey(handOver.libraryKey);
  deps.log(`[pairing] signed in as user ${user.id} with the library key from the phone`);
  return "verified";
};

/**
 * ACCT-PAIR-01: "Get the key from another device" on the key step. This computer is already signed in; another signed-in
 * device approved a key-only request, so only the library key arrives. It goes through the same check-and-keep as a
 * typed key (`setLibraryKey`), so a key that does not open the library is never stored.
 */
export const completeParrotKeyPairing = async (
  setLibraryKey: (key: string) => Promise<AccountKeyResult>,
  handOver: PairingHandOver,
  log: (line: string) => void,
): Promise<PairedKeyCheck> => {
  const verdict = await setLibraryKey(handOver.libraryKey);
  if (!verdict.ok) {
    if (verdict.error === "network") throw new Error(`could not check the library key: ${verdict.message ?? "network"}`);
    log(`[pairing] the key from the other device does not open the library of user ${handOver.user.id} (${verdict.error}); nothing stored`);
    return "mismatch";
  }
  log(`[pairing] kept the library key from another device for user ${handOver.user.id}`);
  return "verified";
};
