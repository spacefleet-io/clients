import type { User } from "@space/shared/api";
import { getLibraryMetaForKeyStep } from "@/api";
import { decryptBase64ToBytes } from "@/lib/crypto";
import { LibraryDb } from "@/lib/libraryDb";
import { isDecryptFailureMessage } from "@/lib/libraryContext";
import { acknowledgeLibraryKey, storeLibraryKey } from "@/lib/onboarding";
import type { PairedKeyCheckDeps, PairedSignInDeps } from "./pairedSignIn";

/** Production wiring for `verifyPairedKey`: the checks the manual key entry screen runs. */
export const pairedKeyCheckDeps: PairedKeyCheckDeps = {
  getLibraryMeta: (token) => getLibraryMetaForKeyStep(token),
  decryptProbe: decryptBase64ToBytes,
  openLibraryDb: async (token, key, userId) => {
    (await LibraryDb.open(token, key, userId)).close();
  },
  isDecryptFailure: isDecryptFailureMessage,
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
