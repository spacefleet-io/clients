import { useMobileSignOut } from "@space/mobile-shell/sign-out";
import { libraryKeyStore } from "../lib/stores";
import { useSession } from "./session";

/**
 * Parrot's Sign out (ACCT-DEV-03, `useMobileSignOut`): a phone that holds the library key first asks whether it was
 * saved, a phone without one (the key-entry screen before a key is saved) signs out at once.
 */
export const useSignOut = (): (() => Promise<void>) => {
  const { signOut } = useSession();
  return useMobileSignOut({ readStoredKey: libraryKeyStore.get, signOut, keyPrefix: "parrot.settings.signOutKey" });
};
