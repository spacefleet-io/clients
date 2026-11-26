import { isSubscriptionUnpaidError } from "@space/shared/subscriptionUnpaid";

/**
 * PRIV-KEY-01: whether a key typed in, or handed over by another device (ACCT-PAIR-01 / PRIV-KEY-05), is the account's
 * key. One key per account, shared by Badger and Parrot, so both desktops run this one check before keeping a key, on
 * every path that takes one (the key step, a key-only pairing, a paired sign-in). It stores nothing, except that an
 * app that passes `claimAccount` makes a key the account's when the account has none.
 *
 * The account's key probe decides (GET /library/db/meta `keyProbe`, account-wide, pinned by the server), as for a
 * kept key (`checkKeptLibraryKey`): with no library in this app yet, a key made in the other app is still the only
 * right one, and taking another key here would encrypt this app's library under it and split the two apps for good.
 * - A probe: the key must open it.
 * - No probe (an account from before probes): the key must open the first library in `appIds` that exists (the asking
 *   app's own first); a library it cannot open (a decrypt failure) means a wrong key.
 * - No probe and no library: the account has no key yet. With `claimAccount` the key is made the account's (the probe
 *   is written); without it the key is taken and the app writes the probe when it publishes its first library.
 * - Anything else (offline, server error): "network"; nothing is decided about the key.
 * - The account's first library refused because the plan has ended (402 `subscription_unpaid`, ACCT-UNPAID-06):
 *   "unpaid"; the key is right but nothing is kept, and setup shows that the library waits for a renewal.
 */
export type AccountKeyResult =
  | { ok: true }
  | { ok: false; error: "format" | "wrongKey" | "network" | "unpaid"; message?: string };

export type AccountKeyCheckDeps<A extends string> = {
  /** The apps whose library the key is tried on when the account has no probe, in order: the asking app's own first. */
  appIds: readonly A[];
  /** The account's key probe (encrypted with the account key when it was made), null when no key was ever made. */
  fetchKeyProbe: () => Promise<string | null>;
  /** Decrypts the probe with the key; throws when the key is not the one that made it. */
  decryptProbe: (key: string, probe: string) => Promise<unknown>;
  /** The app's library opened with the key; null when the app has no library; throws a decrypt failure on a wrong key. */
  fetchSnapshot: (appId: A) => Promise<unknown>;
  /** Whether a `fetchSnapshot` error is the key failing to decrypt the library; default: the error is `DECRYPT_FAILED`. */
  isDecryptFailure?: (error: unknown) => boolean;
  /** Makes `key` the account's (writes the key probe). Called only when the account has no probe and no library. */
  claimAccount?: (key: string) => Promise<void>;
  log: (message: string) => void;
  fail: (message: string) => void;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A library key is 32 bytes, written as standard base64. */
const isLibraryKeyFormat = (key: string) => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) return false;
  try {
    return atob(key).length === 32;
  } catch {
    return false;
  }
};

/** Whether `key` is the account's key (see the module comment). */
// tla: VaultKeys/Enter
export const checkKeyAgainstAccount = async <A extends string>(key: string, deps: AccountKeyCheckDeps<A>): Promise<AccountKeyResult> => {
  if (!isLibraryKeyFormat(key)) {
    deps.log("[key] the key is not 32 bytes of base64");
    return { ok: false, error: "format" };
  }
  let probe: string | null;
  try {
    probe = await deps.fetchKeyProbe();
  } catch (error) {
    deps.fail(`[key] could not read the account's key probe: ${errorText(error)}`);
    return { ok: false, error: "network", message: errorText(error) };
  }
  if (probe) {
    try {
      await deps.decryptProbe(key, probe);
    } catch {
      deps.log("[key] the key does not open the account's key probe");
      return { ok: false, error: "wrongKey" };
    }
    deps.log("[key] the key opens the account's key probe");
    return { ok: true };
  }
  const isDecryptFailure = deps.isDecryptFailure ?? ((error: unknown) => errorText(error) === "DECRYPT_FAILED");
  for (const appId of deps.appIds) {
    try {
      if (!(await deps.fetchSnapshot(appId))) {
        deps.log(`[key] no key probe and no ${appId} library to check the key against`);
        continue;
      }
    } catch (error) {
      if (isDecryptFailure(error)) {
        deps.log(`[key] the key does not open the ${appId} library`);
        return { ok: false, error: "wrongKey" };
      }
      deps.fail(`[key] could not check the key against the ${appId} library: ${errorText(error)}`);
      return { ok: false, error: "network", message: errorText(error) };
    }
    deps.log(`[key] no key probe; the key opens the ${appId} library`);
    return { ok: true };
  }
  if (!deps.claimAccount) {
    deps.log("[key] the account has no key probe and no library yet: the key is taken, its first library writes the probe");
    return { ok: true };
  }
  try {
    await deps.claimAccount(key);
  } catch (error) {
    if (isSubscriptionUnpaidError(error)) {
      deps.log("[key] the account's first library was refused: the plan has ended (subscription_unpaid)");
      return { ok: false, error: "unpaid", message: errorText(error) };
    }
    deps.fail(`[key] could not write the account's key probe: ${errorText(error)}`);
    return { ok: false, error: "network", message: errorText(error) };
  }
  deps.log("[key] the account had no key yet: the key is the account's now (probe written)");
  return { ok: true };
};
