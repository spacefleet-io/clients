import type { User } from "@space/shared/api";
import { getLibraryMetaForKeyStep } from "@/api";
import { decryptBase64ToBytes } from "@/lib/crypto";
import { LibraryDb } from "@/lib/libraryDb";
import { isDecryptFailureMessage } from "@/lib/libraryContext";
import { acknowledgeLibraryKey, storeLibraryKey } from "@/lib/onboarding";
import { rendererLogger } from "@/logger";
import type { PairedKeyCheckDeps, PairedSignInDeps } from "./pairedSignIn";

const keyLog = rendererLogger.child({ scope: "account-key" });

/** Production wiring for Badger's side of the account key check (typed key, key from another device, paired sign-in). */
export const pairedKeyCheckDeps: PairedKeyCheckDeps = {
  getLibraryMeta: (token) => getLibraryMetaForKeyStep(token),
  decryptProbe: decryptBase64ToBytes,
  openLibraryDb: async (token, key, userId) => {
    (await LibraryDb.open(token, key, userId)).close();
  },
  isDecryptFailure: isDecryptFailureMessage,
  log: (message, extra) => keyLog.info(extra ?? {}, message),
};

/** Production wiring for `completePairedSignIn`: the same helpers the manual key entry screen uses. */
export const createPairedSignInDeps = (
  setSession: (token: string, user: User) => void,
  log: PairedSignInDeps["log"],
): PairedSignInDeps => ({
  ...pairedKeyCheckDeps,
  setSession,
  storeLibraryKey,
  setMediaKey: async (key) => window.sf?.setMediaKey?.(key).catch(() => undefined),
  forwardKeyToRuntime: async (userId, key) => window.sf?.forwardKeyToRuntime?.(userId, key).catch(() => undefined),
  acknowledgeLibraryKey,
  log,
});
