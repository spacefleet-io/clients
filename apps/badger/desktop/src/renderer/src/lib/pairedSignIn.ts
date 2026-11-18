/**
 * ACCT-PAIR-01 / PRIV-KEY-05: finishes a "Sign in with your phone" sign-in on this computer.
 *
 * The phone hands over a session token and the library key. Before anything is stored the key is checked against
 * the library the way manual key entry does it (the library `keyProbe`, else opening the library database), so a
 * key that cannot open this account's library never replaces anything. After that the token and key are stored
 * exactly like a password login followed by typing the key by hand.
 */
import type { LibraryMeta, User } from "@space/shared/api";
import type { PairingPoll } from "@space/desktop-shell/pairing";

export type ApprovedPairing = Extract<PairingPoll, { status: "approved" }>;

export type PairedKeyCheck = "verified" | "mismatch";

export type PairedKeyCheckDeps = {
  getLibraryMeta: (token: string) => Promise<Pick<LibraryMeta, "exists" | "keyProbe">>;
  /** Throws when `key` cannot decrypt `payloadBase64`. */
  decryptProbe: (key: string, payloadBase64: string) => Promise<unknown>;
  /** Opens `userId`'s library database with the key and closes it again; throws when the key is wrong. */
  openLibraryDb: (token: string, key: string, userId: string) => Promise<void>;
  isDecryptFailure: (error: unknown) => boolean;
};

export type PairedSignInDeps = PairedKeyCheckDeps & {
  setSession: (token: string, user: User) => void;
  storeLibraryKey: (key: string) => Promise<void>;
  setMediaKey: (key: string) => Promise<unknown>;
  forwardKeyToRuntime: (userId: string, key: string) => Promise<unknown>;
  acknowledgeLibraryKey: () => Promise<void>;
  log?: (message: string, extra?: Record<string, unknown>) => void;
};

/** Whether the key received from the phone opens this account's library. A brand-new account has nothing to check. */
export const verifyPairedKey = async (
  deps: PairedKeyCheckDeps,
  token: string,
  key: string,
  userId: string,
): Promise<PairedKeyCheck> => {
  const meta = await deps.getLibraryMeta(token);
  if (!meta.exists) return "verified";
  try {
    if (meta.keyProbe) {
      await deps.decryptProbe(key, meta.keyProbe);
    } else {
      await deps.openLibraryDb(token, key, userId);
    }
    return "verified";
  } catch (error) {
    // A wrong key surfaces as a decrypt failure; anything else (network, disk) is not the key's fault.
    if (meta.keyProbe || deps.isDecryptFailure(error)) return "mismatch";
    throw error;
  }
};

/** Verifies and stores a paired sign-in. Resolves "mismatch" with nothing stored when the key is wrong. */
export const completePairedSignIn = async (
  deps: PairedSignInDeps,
  approved: ApprovedPairing,
): Promise<PairedKeyCheck> => {
  const { token, user, libraryKey } = approved;
  const check = await verifyPairedKey(deps, token, libraryKey, user.id);
  if (check === "mismatch") {
    deps.log?.("paired sign-in: key does not open this library, nothing stored", { userId: user.id });
    return "mismatch";
  }
  // The session first: library keys are stored per user, and the user comes from the session.
  deps.setSession(token, user as User);
  await deps.storeLibraryKey(libraryKey);
  await deps.setMediaKey(libraryKey);
  await deps.forwardKeyToRuntime(user.id, libraryKey);
  await deps.acknowledgeLibraryKey();
  deps.log?.("paired sign-in: signed in and library key stored", { userId: user.id });
  return "verified";
};
