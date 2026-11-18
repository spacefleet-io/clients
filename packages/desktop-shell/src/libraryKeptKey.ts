/**
 * PRIV-KEY-01: whether the library key an app kept is still the account's. The vault is the account's, shared by
 * Badger and Parrot on every device and profile, so an erase from any of them (POST /library/recovery/reset) leaves
 * the account with no library and no key probe, then a new key's probe once that key is saved. An app that kept the
 * erased key must forget it and go back to the key step: it must never open, sync or publish under it again.
 *
 * - "account": the kept key opens the account's key probe, or (an account from before probes) a library.
 * - "stale": the probe does not open with it, a library does not open with it, or the account has no key at all
 *   (no probe, no library: erased). The app forgets the key, closes the library, clears its local cache and shows
 *   the key step, which asks for the account's key when there is a probe and offers a new one when there is none.
 * - "unknown": the server did not answer. The key stays (an offline start keeps working).
 */
export type KeptLibraryKeyVerdict = "account" | "stale" | "unknown";

export type KeptLibraryKeyDeps = {
  /** The account's key probe (GET /library/db/meta `keyProbe`, account-wide), null when it has none; throws offline. */
  readKeyProbe: () => Promise<string | null>;
  /** Opens the probe with the key; throws when the key is not the one that made it. */
  decryptProbe: (keyBase64: string, probe: string) => Promise<unknown>;
  /**
   * Only asked when the account has no probe: whether the key opens a library of the account (true), a library
   * exists that it cannot open (false), or the account has no library at all (null). Throws when offline.
   */
  opensAccountLibrary: (keyBase64: string) => Promise<boolean | null>;
  log?: (message: string) => void;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const checkKeptLibraryKey = async (keyBase64: string, deps: KeptLibraryKeyDeps): Promise<KeptLibraryKeyVerdict> => {
  const log = deps.log ?? (() => undefined);
  let probe: string | null;
  try {
    probe = await deps.readKeyProbe();
  } catch (error) {
    log(`[key] kept key not checked, the account's key probe could not be read: ${errorText(error)}`);
    return "unknown";
  }
  if (probe) {
    try {
      await deps.decryptProbe(keyBase64, probe);
      return "account";
    } catch {
      log("[key] the kept key does not open the account's key probe: it is not the account's key any more");
      return "stale";
    }
  }
  let opens: boolean | null;
  try {
    opens = await deps.opensAccountLibrary(keyBase64);
  } catch (error) {
    log(`[key] kept key not checked, the account's library could not be read: ${errorText(error)}`);
    return "unknown";
  }
  if (opens === true) return "account";
  log(
    opens === false
      ? "[key] the kept key does not open the account's library: it is not the account's key any more"
      : "[key] the account has no library and no key (erased): the kept key is forgotten",
  );
  return "stale";
};
