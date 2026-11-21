/**
 * The real side effects of a new-device pairing, shared by Badger TV and the Parrot phone (shared-packages default):
 * the key check against the account's key probe and the completion wiring around `completePairing`.
 * Each app passes only what differs: its library name, its decrypt function and its log tag.
 */
import { ApiError, getLibraryMeta, getMe, logout } from "@space/shared/api";
import { scopeLogger } from "../logger";
import type { KeyCheck, PairingCompletionDeps } from "./completion";

export type PairingRuntimeOptions = {
  /** Library the key must open, e.g. "badger" or "parrot". */
  library: NonNullable<Parameters<typeof getLibraryMeta>[1]>;
  /** Opens a base64 envelope with a base64 key; any throw means the key does not open it. */
  decrypt: (keyBase64: string, payloadBase64: string) => Promise<unknown>;
  /** Log prefix of every pairing line, e.g. "tv.pairing". */
  logTag: string;
  /** The op stream the app reads, declared on the key probe read: a switched account answers 426 without it (LIB-FMT-13). */
  readOpStreamVersion?: number;
};

/** Does the library key the approver sent open this account's library? (Same probe the desktop app uses.) */
export const createPairingKeyCheck =
  ({ library, decrypt, logTag, readOpStreamVersion }: PairingRuntimeOptions) =>
  async (token: string, libraryKey: string): Promise<KeyCheck> => {
    const log = scopeLogger(logTag);
    const meta = await getLibraryMeta(token, library, readOpStreamVersion).catch((error: unknown) => {
      log.warn("verify_key.meta_failed", { status: error instanceof ApiError ? error.status : null });
      return null;
    });
    if (!meta?.exists || !meta.keyProbe) return "unchecked";
    try {
      await decrypt(libraryKey, meta.keyProbe);
      return "ok";
    } catch (error) {
      // Any failure to open the probe means this key is not the library's key: quick-crypto reports a wrong key as
      // "Unsupported state or unable to authenticate data", not as a named error, and a wrong key must never be stored.
      log.warn("verify_key.mismatch", { message: error instanceof Error ? error.message : String(error) });
      return "mismatch";
    }
  };

export type PairingCompletionSetup = PairingRuntimeOptions &
  Pick<PairingCompletionDeps, "setStoredLibraryKey" | "setLibraryKeyAcknowledged" | "setSession"> & {
    /**
     * Key mode (ACCT-PAIR-01, key screen): the token is this device's own session, so a refused key never signs it
     * out; only a new session from a sign-in pairing is dropped.
     */
    keepSession?: boolean;
  };

export const createPairingCompletionDeps = (setup: PairingCompletionSetup): PairingCompletionDeps => ({
  fetchUser: async (token) => (await getMe(token)).user,
  verifyKey: createPairingKeyCheck(setup),
  setStoredLibraryKey: setup.setStoredLibraryKey,
  setLibraryKeyAcknowledged: setup.setLibraryKeyAcknowledged,
  setSession: setup.setSession,
  discardSession: async (token) => {
    if (setup.keepSession) return;
    await logout(token);
  },
  logTag: setup.logTag,
});
