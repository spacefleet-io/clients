import type { ParrotCreateKeyResult, ParrotKeyResult } from "../shared/ipc";

/** The library apps whose snapshot a key is tried on, Parrot's first. */
export const KEY_CHECK_APP_IDS = ["parrot", "badger"] as const;
export type KeyCheckAppId = (typeof KEY_CHECK_APP_IDS)[number];

export type LibraryKeyCheckDeps<S> = {
  /** The app's library snapshot opened with the key; null when the app has no library; throws DECRYPT_FAILED on a wrong key. */
  fetchSnapshot: (appId: KeyCheckAppId) => Promise<S | null>;
  /** The account's key probe (encrypted with the account key when it was made), null when no key was ever made. */
  fetchKeyProbe: () => Promise<string | null>;
  /** Decrypts the probe with the key; throws when the key is not the one that made it. */
  decryptProbe: (key: string, probe: string) => Promise<unknown>;
  /**
   * Makes `key` the account's: publishes Parrot's first (empty) library, which writes the account's key probe, so
   * every Badger and Parrot app checks later keys against it. Called only when the account has no library and no probe.
   */
  claimAccount: (key: string) => Promise<void>;
  log: (message: string) => void;
  fail: (message: string) => void;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const isLibraryKeyFormat = (key: string) =>
  /^[A-Za-z0-9+/]+={0,2}$/.test(key) && Buffer.from(key, "base64").length === 32;

/**
 * Whether `key` is the account's key (PRIV-KEY-01: one key per account, shared by Badger and Parrot); stores nothing.
 * The key must open Parrot's library when there is one, else Badger's. With no library yet, it must open the account's
 * key probe: a key made in Badger exists before any library is published, and taking another key here would encrypt
 * Parrot's library under it and split the two apps for good. Only an account with no probe at all takes any key, and
 * taking it writes the probe (`claimAccount`). `onParrotLibrary` gets the opened Parrot library.
 */
export const checkKeyAgainstAccount = async <S>(
  key: string,
  deps: LibraryKeyCheckDeps<S>,
  onParrotLibrary?: (snapshot: S) => void,
): Promise<ParrotKeyResult> => {
  if (!isLibraryKeyFormat(key)) return { ok: false, error: "format" };
  for (const appId of KEY_CHECK_APP_IDS) {
    try {
      const snapshot = await deps.fetchSnapshot(appId);
      if (!snapshot) {
        deps.log(`[key] no ${appId} library to check the key against`);
        continue;
      }
      deps.log(`[key] the key opens the ${appId} library`);
      if (appId === "parrot") onParrotLibrary?.(snapshot);
      return { ok: true };
    } catch (error) {
      if (errorText(error) === "DECRYPT_FAILED") {
        deps.log(`[key] the key does not open the ${appId} library`);
        return { ok: false, error: "wrongKey" };
      }
      deps.fail(`[key] could not check the key against the ${appId} library: ${errorText(error)}`);
      return { ok: false, error: "network", message: errorText(error) };
    }
  }
  let probe: string | null;
  try {
    probe = await deps.fetchKeyProbe();
  } catch (error) {
    deps.fail(`[key] could not read the account's key probe: ${errorText(error)}`);
    return { ok: false, error: "network", message: errorText(error) };
  }
  if (!probe) {
    try {
      await deps.claimAccount(key);
    } catch (error) {
      deps.fail(`[key] could not write the account's key probe: ${errorText(error)}`);
      return { ok: false, error: "network", message: errorText(error) };
    }
    deps.log("[key] the account had no key yet: the key is the account's now (probe written)");
    return { ok: true };
  }
  try {
    await deps.decryptProbe(key, probe);
  } catch {
    deps.log("[key] the key does not open the account's key probe");
    return { ok: false, error: "wrongKey" };
  }
  deps.log("[key] the key opens the account's key probe");
  return { ok: true };
};

/**
 * The key step's first question (UX-KEY-01): an account with no library and no key probe gets a new key to show
 * (nothing stored until the user has written it down and it is checked in with `checkKeyAgainstAccount`); an account
 * that already has a key (a probe, or a library a fresh key cannot open) answers "hasLibrary" and the step asks for it.
 */
export const makeAccountKey = async (
  newKey: { keyBase64: string; words: string[] },
  deps: Pick<LibraryKeyCheckDeps<unknown>, "fetchSnapshot" | "fetchKeyProbe" | "log" | "fail">,
): Promise<ParrotCreateKeyResult> => {
  try {
    if (await deps.fetchKeyProbe()) {
      deps.log("[key] the account already has a key (its probe is on the server): asking for it");
      return { ok: false, error: "hasLibrary" };
    }
  } catch (error) {
    deps.fail(`[key] could not read the account's key probe: ${errorText(error)}`);
    return { ok: false, error: "network", message: errorText(error) };
  }
  for (const appId of KEY_CHECK_APP_IDS) {
    try {
      if (await deps.fetchSnapshot(appId)) return { ok: false, error: "hasLibrary" };
    } catch (error) {
      if (errorText(error) === "DECRYPT_FAILED") {
        deps.log(`[key] the account already has a ${appId} library: asking for its key`);
        return { ok: false, error: "hasLibrary" };
      }
      deps.fail(`[key] could not check for an existing ${appId} library: ${errorText(error)}`);
      return { ok: false, error: "network", message: errorText(error) };
    }
  }
  deps.log("[key] the account has no key yet: a new one is shown");
  return { ok: true, ...newKey };
};
