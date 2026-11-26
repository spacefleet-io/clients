/**
 * ACCT-PAIR-01 / PRIV-KEY-05: finishes a "Sign in with your phone" sign-in on this computer.
 *
 * The phone hands over a session token and the library key. Before anything is stored the key goes through the
 * desktops' one account key check (`@space/desktop-shell/account-key-check`, PRIV-KEY-01), the same check a typed key
 * goes through, so a key that is not the account's never replaces anything. After that the token and key are stored
 * exactly like a password login followed by typing the key by hand.
 */
import type { LibraryMeta, User } from "@space/shared/api";
import type { PairedKeyCheck, PairingPoll } from "@space/desktop-shell/pairing";
import { checkKeyAgainstAccount, type AccountKeyResult } from "@space/desktop-shell/account-key-check";

export type ApprovedPairing = Extract<PairingPoll, { status: "approved" }>;

/** Badger's side of the account key check: what its renderer can read of the account's library and key probe. */
export type PairedKeyCheckDeps = {
  getLibraryMeta: (token: string) => Promise<Pick<LibraryMeta, "exists" | "keyProbe">>;
  /** Throws when `key` cannot decrypt `payloadBase64`. */
  decryptProbe: (key: string, payloadBase64: string) => Promise<unknown>;
  /** Opens `userId`'s library database with the key and closes it again; throws when the key is wrong. */
  openLibraryDb: (token: string, key: string, userId: string) => Promise<void>;
  isDecryptFailure: (error: unknown) => boolean;
  log?: (message: string, extra?: Record<string, unknown>) => void;
};

export type PairedSignInDeps = PairedKeyCheckDeps & {
  setSession: (token: string, user: User) => void;
  storeLibraryKey: (key: string) => Promise<void>;
  setMediaKey: (key: string) => Promise<unknown>;
  forwardKeyToRuntime: (userId: string, key: string) => Promise<unknown>;
  acknowledgeLibraryKey: () => Promise<void>;
};

/**
 * Whether `key` is the account's key, by the shared check. Badger tries its own library only: Parrot's snapshot is read
 * with Node crypto, which the renderer does not have, and a Parrot library always comes with the account-wide key
 * probe, which the check opens before any library. Badger does not claim an account with no key: its first library
 * writes the probe when it is published. `meta` is the library meta the caller already read, if any.
 */
export const checkKeyForBadger = (
  deps: PairedKeyCheckDeps,
  token: string,
  key: string,
  userId: string,
  meta?: Pick<LibraryMeta, "exists" | "keyProbe">,
): Promise<AccountKeyResult> => {
  let read = meta ? Promise.resolve(meta) : null;
  const libraryMeta = () => (read ??= deps.getLibraryMeta(token));
  const log = (message: string) => deps.log?.(message, { userId });
  return checkKeyAgainstAccount(key, {
    appIds: ["badger"],
    fetchSnapshot: async () => {
      if (!(await libraryMeta()).exists) return null;
      await deps.openLibraryDb(token, key, userId);
      return true;
    },
    fetchKeyProbe: async () => (await libraryMeta()).keyProbe ?? null,
    decryptProbe: deps.decryptProbe,
    isDecryptFailure: deps.isDecryptFailure,
    log,
    fail: log,
  });
};

/** A key from another device: "mismatch" when it is not the account's key; throws when the check could not run. */
export const verifyPairedKey = async (
  deps: PairedKeyCheckDeps,
  token: string,
  key: string,
  userId: string,
): Promise<PairedKeyCheck> => {
  const result = await checkKeyForBadger(deps, token, key, userId);
  if (result.ok) return "verified";
  // Anything else (network, disk, a plan that has ended) is not the key's fault: nothing is decided, the sign-in fails.
  if (result.error === "network" || result.error === "unpaid") throw new Error(result.message ?? "could not check the library key");
  return "mismatch";
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
